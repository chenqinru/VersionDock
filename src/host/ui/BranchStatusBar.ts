import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { RepoMeta } from '../types/git';
import type { SvnIgnoreEntry } from '../svn/SvnService';
import { isPrimaryBranch } from '../utils/branchUtils';
import { t } from '../utils/l10n';
import { showGitErrorMessage } from '../utils/gitError';
import {
  getAbortOperationDescription,
  getAbortOperationLabel,
  getAbortOperationName,
  runAbortOperationFlow,
  type AbortOperationTarget,
} from '../utils/abortOperation';
import { formatRepoLabel } from '../utils/repoLabels';
import type { VersionDockLogger } from '../utils/Logger';
import { isRemoteRepositoryCancelled } from '../remote/types';
import { withGitPushProgress } from '../utils/pushProgress';
import { runPushWithProtection } from '../utils/pushProtection';
import type { UpdateSummaryService } from '../update/UpdateSummaryService';

type SvnIgnoreRepo = {
  addIgnoreEntry(entryPath: string): Promise<{ entry: string; directoryPath: string; alreadyExists: boolean }>;
  listIgnoreEntries(): Promise<SvnIgnoreEntry[]>;
  removeIgnoreEntries(entries: SvnIgnoreEntry[]): Promise<void>;
};

type SvnIgnorePickItem = vscode.QuickPickItem & { entry: SvnIgnoreEntry };
type SvnIgnoreActionPickItem = vscode.QuickPickItem & { action: 'add' | 'remove' };
type SvnIgnoreCandidatePickItem = vscode.QuickPickItem & { filePath?: string; custom?: boolean };

function truncateBranchName(name: string, maxLength = 28): string {
  if (name.length <= maxLength) return name;
  const keep = Math.floor((maxLength - 3) / 2);
  return `${name.slice(0, keep)}...${name.slice(name.length - keep)}`;
}

function formatOperationStateLabel(state: string): string {
  switch (state.toLowerCase()) {
    case 'merge':
      return t('MERGE');
    case 'rebase':
      return t('REBASE');
    case 'cherry-pick':
      return t('CHERRY-PICK');
    case 'revert':
      return t('REVERT');
    default:
      return state.toUpperCase();
  }
}

export class BranchStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private statusDisposable?: vscode.Disposable;
  private statusOperationDisposable?: vscode.Disposable;
  private branchDisposable?: vscode.Disposable;
  private configDisposable?: vscode.Disposable;
  private editorDisposable?: vscode.Disposable;
  private hasBehind = false;
  private hasUnpushed = false;
  private hasNoUpstream = false;
  private branchesDiverged = false;
  private hasUncommitted = false;
  private hasConflicts = false;
  private totalAhead = 0;
  private totalBehind = 0;
  private totalConflicts = 0;
  private conflictRepoCount = 0;
  private refreshVersion = 0;
  private statusOperationInProgress = false;
  private activeOperationKind?: import('../git/GitService').StatusOperationKind;
  private activeOperationLabel?: string;
  private windowStateDisposable?: vscode.Disposable;
  private recentBranches = new Map<string, string[]>();

  private recordRecentBranch(repoId: string, branchName: string): void {
    if (!branchName || branchName === 'HEAD') return;
    const existing = this.recentBranches.get(repoId) ?? [];
    const filtered = existing.filter(name => name !== branchName);
    filtered.unshift(branchName);
    this.recentBranches.set(repoId, filtered.slice(0, 3));
  }

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly commitPanelReveal: () => void,
    private readonly logger: VersionDockLogger,
    private readonly updateSummaryService: UpdateSummaryService,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'versiondock.showBranchMenu';
    this.statusBarItem.tooltip = t('VersionDock: Git/SVN Menu');
    this.statusBarItem.show();

    this.statusDisposable = this.manager.onStatusChange(status => {
      void this.refresh(status).catch(error => {
        this.logger.error('BranchStatus', 'Failed to refresh status', error);
      });
    });
    this.statusOperationDisposable = this.manager.onStatusOperationChange((inProgress, kind, label) => {
      if (inProgress) {
        this.showLoadingSpin(kind, label);
      } else {
        this.hideLoadingSpin(() => this.refreshFromManager());
      }
    });
    // Also refresh on branch change: the status change fires at 300ms and may catch
    // a transient HEAD state during checkout. The branch change fires at 400ms when
    // the VS Code Git API state is stable, ensuring the status bar corrects itself.
    this.branchDisposable = this.manager.onBranchChange(() => this.refreshFromManager());
    this.configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('versiondock.suppressDivergedBranchWarning')) {
        void this.refresh().catch(error => {
          this.logger.error('BranchStatus', 'Failed to apply configuration', error);
        });
      }
    });
    this.editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      void this.refresh().catch(error => {
        this.logger.error('BranchStatus', 'Failed to refresh on active editor change', error);
      });
    });
    this.windowStateDisposable = vscode.window.onDidChangeWindowState(state => {
      if (state.focused) {
        // Auto-sync: if spinner is stuck while returning to foreground, calibrate and refresh
        if (this.statusOperationInProgress && Date.now() - this.loadingStartTime > this.minLoadingDuration) {
          this.refreshFromManager();
        }
      }
    });
    this.refreshFromManager();
  }

  private loadingDepth = 0;
  private loadingTimer?: NodeJS.Timeout;
  private safetyTimeoutTimer?: NodeJS.Timeout;
  private loadingStartTime = 0;
  private readonly minLoadingDuration = 180;
  private readonly safetyTimeoutDuration = 45_000;

  showLoadingSpin(kind?: import('../git/GitService').StatusOperationKind, label?: string): void {
    this.loadingDepth++;
    this.statusOperationInProgress = true;
    this.activeOperationKind = kind ?? this.activeOperationKind;
    this.activeOperationLabel = label ?? this.activeOperationLabel;
    this.loadingStartTime = Date.now();

    if (this.loadingTimer) {
      clearTimeout(this.loadingTimer);
      this.loadingTimer = undefined;
    }

    // Set safety timeout to prevent permanent spinner hang if an operation never settles
    if (!this.safetyTimeoutTimer) {
      this.safetyTimeoutTimer = setTimeout(() => {
        this.logger.warn('BranchStatus', 'Safety timeout reached for status loading; resetting spinner');
        this.forceResetLoading();
      }, this.safetyTimeoutDuration);
    }

    // Neutralize background during loading to focus on the animation
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.text = this.statusBarItem.text.replace(
      /\$\((?:git-branch|tag|git-commit)\)/,
      '$(loading~spin)',
    );
  }

  hideLoadingSpin(onSettled?: () => void): void {
    this.loadingDepth = Math.max(0, this.loadingDepth - 1);
    if (this.loadingDepth > 0) {
      // Still other concurrent operations in flight
      onSettled?.();
      return;
    }

    this.activeOperationKind = undefined;
    this.activeOperationLabel = undefined;

    // Clear safety timeout when all operations settle
    if (this.safetyTimeoutTimer) {
      clearTimeout(this.safetyTimeoutTimer);
      this.safetyTimeoutTimer = undefined;
    }

    const elapsed = Date.now() - this.loadingStartTime;
    const remaining = Math.max(0, this.minLoadingDuration - elapsed);

    const settle = () => {
      this.statusOperationInProgress = false;
      this.loadingTimer = undefined;
      onSettled?.();
      void this.refresh();
    };

    if (remaining > 0) {
      if (this.loadingTimer) clearTimeout(this.loadingTimer);
      this.loadingTimer = setTimeout(settle, remaining);
    } else {
      settle();
    }
  }

  private forceResetLoading(): void {
    this.loadingDepth = 0;
    this.statusOperationInProgress = false;
    this.activeOperationKind = undefined;
    this.activeOperationLabel = undefined;
    if (this.safetyTimeoutTimer) {
      clearTimeout(this.safetyTimeoutTimer);
      this.safetyTimeoutTimer = undefined;
    }
    if (this.loadingTimer) {
      clearTimeout(this.loadingTimer);
      this.loadingTimer = undefined;
    }
    this.refreshFromManager();
  }

  async withOperationProgress<T>(
    operation: () => Promise<T>,
    kind?: import('../git/GitService').StatusOperationKind,
    label?: string,
  ): Promise<T> {
    this.showLoadingSpin(kind, label);
    try {
      return await operation();
    } finally {
      this.hideLoadingSpin(() => this.refreshFromManager());
    }
  }

  private refreshFromManager(): void {
    const version = ++this.refreshVersion;
    void this.manager.getAllStatusesFresh()
      .then(status => {
        void this.refresh(status, version);
      })
      .catch(error => {
        this.logger.error('BranchStatus', 'Failed to load status', error);
      });
  }

  async refresh(
    preloadedStatus?: import('../types/git').WorkspaceStatus,
    version = ++this.refreshVersion,
  ): Promise<void> {
    if (version !== this.refreshVersion) return;
    const allMetas = this.manager.getRepoMetas();
    const hasGitRepo = allMetas.some(meta => meta.kind !== 'svn');
    const hasSvnRepo = allMetas.some(meta => meta.kind === 'svn');
    void vscode.commands.executeCommand('setContext', 'versiondock.hasGitRepo', hasGitRepo);
    void vscode.commands.executeCommand('setContext', 'versiondock.hasSvnRepo', hasSvnRepo);
    void vscode.commands.executeCommand('setContext', 'versiondock.svnOnly', hasSvnRepo && !hasGitRepo);
    const nonWorktreeMetas = allMetas.filter(m => !m.isWorktree);
    const metas = nonWorktreeMetas.length > 0 ? nonWorktreeMetas : allMetas;
    if (allMetas.length === 0) {
      this.statusBarItem.text = `$(git-branch) ${t('No repo')}`;
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
      this.hasBehind = false;
      this.hasUnpushed = false;
      this.hasNoUpstream = false;
      this.branchesDiverged = false;
      this.hasUncommitted = false;
      this.hasConflicts = false;
      this.totalAhead = 0;
      this.totalBehind = 0;
      this.totalConflicts = 0;
      this.conflictRepoCount = 0;
      return;
    }

    const worktreeMetas = nonWorktreeMetas.length > 0 ? allMetas.filter(m => m.isWorktree) : [];

    const [statusResult, worktreeBranchResults] = await Promise.all([
      preloadedStatus ?? this.manager.getAllStatusesFresh(),
      Promise.allSettled(worktreeMetas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getCurrentBranch() : null;
      })),
    ]);
    if (version !== this.refreshVersion) return;

    type BranchInfo = Awaited<ReturnType<NonNullable<ReturnType<WorkspaceGitManager['getRepo']>>['getCurrentBranch']>>;

    const nonWorktreeIds = new Set(metas.map(m => m.id));
    const visibleRepoStatuses = statusResult.repos.filter(r => nonWorktreeIds.has(r.repoId));
    const branches = statusResult.repos
      .filter(r => nonWorktreeIds.has(r.repoId))
      .map(r => r.branch);

    const worktreeBranches = worktreeBranchResults
      .filter((r): r is PromiseFulfilledResult<BranchInfo | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(Boolean) as BranchInfo[];

    // Use effective name: detachedTag, detachedHash, or branch name.
    // Diverged-branch warnings are Git-only; SVN branches are URL/layout based.
    const gitMetaIds = new Set(metas.filter(m => m.kind !== 'svn').map(m => m.id));
    const gitBranches = branches.filter(branch => gitMetaIds.has(branch.repoId));
    const gitEffectiveNames = [...new Set(branches
      .filter(b => gitMetaIds.has(b.repoId))
      .map(b => b.detachedTag ?? b.detachedHash ?? b.name))];
    this.branchesDiverged = gitEffectiveNames.length > 1;
    this.totalBehind = branches.reduce((sum, b) => sum + (b.aheadBehind?.behind ?? 0), 0);
    this.totalAhead = branches.reduce((sum, b) => sum + (b.aheadBehind?.ahead ?? 0), 0);
    this.hasBehind = this.totalBehind > 0;
    this.hasUnpushed = gitBranches.some(b => !b.upstream || (b.aheadBehind?.ahead ?? 0) > 0);
    this.hasNoUpstream = gitBranches.some(b => !b.upstream);
    this.hasUncommitted = statusResult.repos.some(
      r => r.stagedFiles.length > 0 || r.unstagedFiles.length > 0
    );
    this.totalConflicts = visibleRepoStatuses.reduce((sum, repo) => sum + repo.conflictCount, 0);
    this.conflictRepoCount = visibleRepoStatuses.filter(repo => repo.conflictCount > 0).length;
    this.hasConflicts = this.totalConflicts > 0;

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeService = activeUri?.scheme === 'file'
      ? this.manager.getServicesForFile(activeUri.fsPath)[0]
      : undefined;
    const activeRepoId = activeService?.repoId;
    const activeRepoStatus = visibleRepoStatuses.find(r => r.repoId === activeRepoId);
    const activeBranchName = activeRepoStatus?.branch
      ? (activeRepoStatus.branch.detachedTag ?? activeRepoStatus.branch.detachedHash ?? activeRepoStatus.branch.name)
      : undefined;

    // Order branch names so the active repository's branch is always primary
    let orderedNames = [...new Set(branches.map(b => b.detachedTag ?? b.detachedHash ?? b.name))];
    if (activeBranchName && orderedNames.includes(activeBranchName)) {
      orderedNames = [activeBranchName, ...orderedNames.filter(n => n !== activeBranchName)];
    }

    const ongoingOperations = visibleRepoStatuses
      .map(r => r.operationState)
      .filter((op): op is NonNullable<import('../types/git').RepoStatus['operationState']> => !!op);
    const hasOngoingOperation = ongoingOperations.length > 0;
    const uniqueOngoingOps = [...new Set(ongoingOperations)];
    const opLabel = uniqueOngoingOps.length === 1
      ? uniqueOngoingOps[0] === 'merge'
        ? t('MERGING')
        : uniqueOngoingOps[0] === 'rebase'
        ? t('REBASING')
        : uniqueOngoingOps[0] === 'cherry-pick'
        ? t('CHERRY-PICKING')
        : t('REVERTING')
      : uniqueOngoingOps.map(op => formatOperationStateLabel(op)).join('/');
    const opSuffix = hasOngoingOperation ? ` (${opLabel})` : '';

    const primaryName = orderedNames[0] ?? 'HEAD';
    const headLabel = orderedNames.length === 1
      ? truncateBranchName(primaryName)
      : `${truncateBranchName(primaryName)} +${orderedNames.length - 1}`;

    // Append worktree branch names after a separator with auto-collapse protection
    const worktreeEffectiveNames = [...new Set(worktreeBranches.map(b => b.detachedTag ?? b.detachedHash ?? b.name))];
    let worktreeSuffix = '';
    if (worktreeEffectiveNames.length === 1) {
      worktreeSuffix = `  |  ${truncateBranchName(worktreeEffectiveNames[0])}`;
    } else if (worktreeEffectiveNames.length > 1) {
      worktreeSuffix = `  |  +${worktreeEffectiveNames.length} ${t('worktrees')}`;
    }

    // Icon: git-branch on a named branch, tag on detached tag, git-commit on detached hash
    const anyOnNamedBranch = branches.some(b => !b.detachedTag && !b.detachedHash && b.name !== 'HEAD');
    const anyOnTag = !anyOnNamedBranch && branches.some(b => !!b.detachedTag);
    const headIcon = this.statusOperationInProgress
      ? '$(loading~spin)'
      : anyOnNamedBranch ? '$(git-branch)' : anyOnTag ? '$(tag)' : '$(git-commit)';

    const suppressDiverged = vscode.workspace.getConfiguration('versiondock').get<boolean>('suppressDivergedBranchWarning') === true;
    const showDivergedWarning = this.branchesDiverged && !suppressDiverged;
    // Diverge warning is kept clean in text/tooltip; warning icon and high-contrast background are reserved for conflicts/ongoing ops
    const alertIcon = this.hasConflicts || hasOngoingOperation ? '$(warning) ' : '';
    const dirtyDot = this.hasUncommitted ? ' ●' : '';
    const pullPart = this.totalBehind > 0 ? ` $(arrow-down)${this.totalBehind}` : '';
    const pushPart = this.totalAhead > 0 ? ` $(arrow-up)${this.totalAhead}` : '';
    const conflictPart = this.totalConflicts > 0 ? ` $(git-merge)${this.totalConflicts}` : '';
    this.statusBarItem.text = `${alertIcon}${headIcon} ${headLabel}${opSuffix}${worktreeSuffix}${dirtyDot}${conflictPart}${pullPart}${pushPart}`;

    // Rich Markdown Tooltip
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;    const titleSuffix = metas.length > 1
      ? ` &nbsp;•&nbsp; ${t('{0} repositories', metas.length)}`
      : '';
    md.appendMarkdown(`**VersionDock**${titleSuffix}\n\n`);

    if (this.statusOperationInProgress) {
      let opDetail = t('Version control operation in progress…');
      if (this.activeOperationKind === 'commit') {
        opDetail = t('Committing changes…');
      } else if (this.activeOperationKind === 'checkout') {
        opDetail = this.activeOperationLabel
          ? t('Checking out "{0}"…', this.activeOperationLabel)
          : t('Checking out branch…');
      } else if (this.activeOperationKind === 'rebase') {
        opDetail = this.activeOperationLabel
          ? t('Rebasing onto "{0}"…', this.activeOperationLabel)
          : t('Rebasing commits…');
      } else if (this.activeOperationKind === 'merge') {
        opDetail = this.activeOperationLabel
          ? t('Merging "{0}"…', this.activeOperationLabel)
          : t('Merging branches…');
      } else if (this.activeOperationKind === 'sync') {
        opDetail = t('Synchronizing with remote repository…');
      } else if (this.activeOperationKind === 'stash') {
        opDetail = t('Stashing/Shelving changes…');
      } else if (this.activeOperationKind === 'cherry-pick') {
        opDetail = t('Cherry-picking commits…');
      } else if (this.activeOperationKind === 'revert') {
        opDetail = t('Reverting commits…');
      }
      md.appendMarkdown(`$(loading~spin) **${opDetail}**\n\n`);
    }

    if (this.hasConflicts) {
      const conflictMsg = this.conflictRepoCount === 1
        ? t('Merge conflicts in {0} repository ({1} files)', this.conflictRepoCount, this.totalConflicts)
        : t('Merge conflicts in {0} repositories ({1} files)', this.conflictRepoCount, this.totalConflicts);
      md.appendMarkdown(`$(warning) **${conflictMsg}**\n\n`);
    }
    if (hasOngoingOperation) {
      md.appendMarkdown(`$(info) **${t('Git operation in progress: {0}', opLabel)}**\n\n`);
    }
    if (showDivergedWarning) {
      md.appendMarkdown(`$(info) ${t('Branches have diverged across repositories')}\n\n`);
    }

    if (metas.length > 0) {
      md.appendMarkdown(`| ${t('Repository')} | ${t('Branch')} | ${t('Sync')} | ${t('Changes')} |\n`);
      md.appendMarkdown(`| :--- | :--- | :---: | :---: |\n`);

      for (const meta of metas) {
        const repoStatus = visibleRepoStatuses.find(r => r.repoId === meta.id);
        const b = repoStatus?.branch;
        const branchDisplay = b
          ? (b.detachedTag ? `$(tag) ${b.detachedTag}` : b.detachedHash ? `$(git-commit) ${b.detachedHash}` : `\`${b.name}\``)
          : '-';
        const repoOp = repoStatus?.operationState ? ` *(${formatOperationStateLabel(repoStatus.operationState)})*` : '';

        let syncText = '-';
        if (meta.kind !== 'svn') {
          if (!b?.upstream) {
            syncText = `*(${t('no upstream')})*`;
          } else {
            const ahead = b.aheadBehind?.ahead ?? 0;
            const behind = b.aheadBehind?.behind ?? 0;
            const parts: string[] = [];
            if (behind > 0) parts.push(`$(arrow-down) ${behind}`);
            if (ahead > 0) parts.push(`$(arrow-up) ${ahead}`);
            syncText = parts.length > 0 ? parts.join(' ') : '$(check)';
          }
        }

        const changesParts: string[] = [];
        if (repoStatus && repoStatus.conflictCount > 0) {
          changesParts.push(`$(git-merge) ${repoStatus.conflictCount}`);
        }
        const stagedCount = repoStatus?.stagedFiles.length ?? 0;
        const unstagedCount = repoStatus?.unstagedFiles.length ?? 0;
        if (stagedCount > 0 || unstagedCount > 0) {
          changesParts.push(`● ${stagedCount + unstagedCount}`);
        }
        if (changesParts.length === 0) {
          changesParts.push(`$(check)`);
        }
        const changesText = changesParts.join(' ');

        const isMixedVcs = hasGitRepo && hasSvnRepo;
        const isActive = meta.id === activeRepoId;
        const activeMarker = isActive && metas.length > 1 ? ` *(${t('Current')})*` : '';
        const repoDisplayName = isMixedVcs
          ? (meta.kind === 'svn' ? `${meta.name} (SVN)` : `${meta.name} (Git)`)
          : meta.name;
        const repoCol = isActive && metas.length > 1
          ? `**${repoDisplayName}**${activeMarker}`
          : `${repoDisplayName}`;
        md.appendMarkdown(`| ${repoCol} | ${branchDisplay}${repoOp} | ${syncText} | ${changesText} |\n`);
      }
      md.appendMarkdown('\n');
    }

    if (worktreeMetas.length > 0) {
      const wtSummary = worktreeMetas.map(m => {
        const branch = worktreeBranches.find(b => b.repoId === m.id);
        const bName = branch ? (branch.detachedTag ?? branch.detachedHash ?? branch.name) : 'HEAD';
        return `\`${m.name}\` (${bName})`;
      }).join(', ');
      md.appendMarkdown(`**${t('Worktrees')}**: ${wtSummary}\n\n`);
    }

    this.statusBarItem.tooltip = md;

    if (this.hasConflicts || hasOngoingOperation) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.color = undefined;
    } else if (this.totalBehind > 0) {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = new vscode.ThemeColor('versiondock.statusBarPullForeground');
    } else if (this.totalAhead > 0) {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = new vscode.ThemeColor('versiondock.statusBarPushForeground');
    } else if (this.hasUncommitted) {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = new vscode.ThemeColor('versiondock.statusBarDirtyForeground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
    }
  }

  async showBranchOptions(repoId: string, branchName: string): Promise<void> {
    const metas = this.manager.getRepoMetas();
    const meta = metas.find(m => m.id === repoId);
    if (!meta) return;
    if (meta.kind === 'svn') {
      await this.showRepoBranchMenu(meta, { showBack: false });
      return;
    }
    const repo = this.manager.getRepo(repoId);
    if (!repo) return;
    const [branches, currentBranch] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
    const remote = branches.filter(b => b.isRemote);
    const remoteNames = new Set(remote.map(r => r.name.replace(/^[^/]+\//, '')));
    const branch = branches.find(b => !b.isRemote && b.name === branchName);
    const isCurrent = branch?.isHead ?? false;
    const hasRemote = isCurrent ? !!currentBranch.upstream : remoteNames.has(branchName);
    const hasUnpushed = !hasRemote || ((branch?.aheadBehind?.ahead ?? 0) > 0);
    const effectiveBranchName = currentBranch.detachedTag ?? currentBranch.detachedHash ?? currentBranch.name;
    await this.showSingleBranchActionMenu(branchName, meta, isCurrent, false, hasUnpushed, effectiveBranchName);
  }

  async showMenu(repoId?: string): Promise<void> {
    if (this.statusOperationInProgress) {
      const waitChoice = await vscode.window.showWarningMessage(
        t('A Git/VCS operation is currently in progress. Please wait for it to complete.'),
        t('Wait and Open Menu'),
      );
      if (waitChoice === t('Wait and Open Menu')) {
        let waited = 0;
        while (this.statusOperationInProgress && waited < 30000) {
          await new Promise(r => setTimeout(r, 200));
          waited += 200;
        }
      } else {
        return;
      }
    }

    const metas = this.manager.getRepoMetas();
    const gitMetas = metas.filter(meta => meta.kind !== 'svn');
    const showRepoKinds = gitMetas.length > 0 && gitMetas.length < metas.length;

    // If a specific repoId was requested and the repo exists, jump straight to its menu
    if (repoId) {
      const meta = metas.find(m => m.id === repoId);
      if (meta) { await this.showRepoBranchMenu(meta, { showBack: false }); return; }
    }

    type MenuItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };

    // Empty workspace / Zero-repo state guidance
    if (metas.length === 0) {
      const emptyItems: MenuItem[] = [
        {
          label: `$(repo-create) ${t('Initialize Git Repository…')}`,
          description: t('Initialize a new Git repository in the current workspace'),
          action: async () => {
            await vscode.commands.executeCommand('git.init');
            this.manager.reinitializeAndRefresh();
          },
        },
        {
          label: `$(refresh) ${t('Reload Repositories')}`,
          description: t('Re-scan workspace folders for Git and SVN repositories'),
          action: () => {
            this.manager.reinitializeAndRefresh();
          },
        },
      ];
      const pick = await vscode.window.showQuickPick(emptyItems, {
        title: t('VersionDock: No Repository Found'),
        placeHolder: t('Select an action to get started…'),
      });
      if (pick) await pick.action();
      return;
    }

    // Single SVN repo direct shortcut
    if (metas.length === 1 && metas[0].kind === 'svn') {
      await this.showSvnRepoMenu(metas[0], { showBack: false });
      return;
    }

    const items: MenuItem[] = [];

    // Detect any repo in merge/rebase conflict state
    const conflictStates = await Promise.all(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        const state = repo ? await repo.getMergeRebaseState() : null;
        return state ? { meta: m, state } : null;
      })
    );
    const inConflict = conflictStates.filter(Boolean) as { meta: RepoMeta; state: 'merge' | 'rebase' }[];

    if (inConflict.length > 0) {
      const resolveConflictsLabel = inConflict.length === 1
        ? t('Resolve Conflicts in {0}', inConflict[0].meta.name)
        : t('Resolve Conflicts in {0} repositories', inConflict.length);

      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
      items.push({
        label: `$(git-merge) ${resolveConflictsLabel}`,
        description: t('Open the conflicts panel to resolve files'),
        action: async () => { await vscode.commands.executeCommand('versiondock.openConflicts'); },
      });
      items.push({
        label: `$(error) ${getAbortOperationLabel(inConflict)}`,
        description: getAbortOperationDescription(inConflict),
        action: () => this.abortOperations(inConflict),
      });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
    }

    const suppressDivergedMenu = vscode.workspace.getConfiguration('versiondock').get<boolean>('suppressDivergedBranchWarning') === true;
    if (this.branchesDiverged && !suppressDivergedMenu) {
      items.push({
        label: `$(warning)  ${t('Branches have diverged')}`,
        detail: `  ${t('Repositories are not on the same branch')}`,
        alwaysShow: true,
        action: async () => {},
      } as unknown as MenuItem);
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} } as unknown as MenuItem);
    }

    if (gitMetas.length > 0) {
      items.push({
        label: `$(sync) ${t('Fetch All')}`,
        description: t('Fetch all branches and tags from remote repositories'),
        action: () => this.fetchAll(),
      });
    }
    items.push({
      label: `${this.hasBehind ? '$(arrow-down) ' : '$(cloud-download) '}${t('Update Project…')}`,
      description: this.hasBehind ? t('Pull all repositories (incoming commits available)') : t('Pull all repositories'),
      action: () => this.updateProject(),
    });
    if (gitMetas.length > 0) {
      items.push({
        label: `${this.hasUnpushed ? '$(arrow-up) ' : '$(cloud-upload) '}${t('Push…')}`,
        description: this.hasUnpushed
          ? this.totalAhead > 0
            ? t('Push commits to remote ({0} to push)', this.totalAhead)
            : t('Push commits to remote (branch not on remote)')
          : this.hasNoUpstream ? t('Some branches have no upstream set') : t('Push current branch to remote'),
        action: () => this.pushMenu(gitMetas),
      });
    }
    items.push({
      label: `$(git-commit) ${t('Commit')}`,
      description: t('Open Commit panel'),
      action: () => this.commitPanelReveal(),
    });
    if (gitMetas.length > 0) {
      items.push({
        label: `$(add) ${t('New Branch…')}`,
        description: t('Create a new branch'),
        action: () => this.newBranch(gitMetas),
      });
    }
    items.push(
      {
        label: `$(history) ${t('Log')}`,
        description: t('Open Git Log panel'),
        action: async () => { await vscode.commands.executeCommand('versiondock.openLog'); },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
    );

    // Per-project section
    if (metas.length > 0) {
      items.push({
        label: t('PROJECTS'),
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as MenuItem);

      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const activeService = activeUri?.scheme === 'file'
        ? this.manager.getServicesForFile(activeUri.fsPath)[0]
        : undefined;
      const activeRepoId = activeService?.repoId;

      for (const meta of metas) {
        const repo = this.manager.getRepo(meta.id);
        let branchName = 'HEAD';
        let repoHasUnpushed = false;
        let isDetachedOnTag = false;
        let repoAhead = 0;
        let repoBehind = 0;
        let repoOpState: string | null = null;
        if (repo) {
          try {
            const [current, opState] = await Promise.all([
              repo.getCurrentBranch(),
              repo.getOperationState?.() ?? Promise.resolve(null),
            ]);
            isDetachedOnTag = !!current.detachedTag;
            branchName = current.detachedTag ?? current.detachedHash ?? current.name;
            repoAhead = current.aheadBehind?.ahead ?? 0;
            repoBehind = current.aheadBehind?.behind ?? 0;
            repoHasUnpushed = repoAhead > 0;
            repoOpState = opState;
          } catch { /* */ }
        }
        const refIcon = isDetachedOnTag ? '$(tag)' : '$(git-branch)';
        const repoIcon = meta.isSubmodule ? '$(package)' : '$(root-folder)';
        const repoPushLabel = repoHasUnpushed ? `  $(arrow-up)${repoAhead > 0 ? repoAhead : ''}` : '';
        const repoPullLabel = repoBehind > 0 ? `  $(arrow-down)${repoBehind}` : '';
        const isActive = metas.length > 1 && meta.id === activeRepoId;
        const activeLabel = isActive ? `  $(edit) ${t('active')}` : '';
        const opLabel = repoOpState ? `  *(${formatOperationStateLabel(repoOpState)})*` : '';
        items.push({
          label: showRepoKinds ? formatRepoLabel(meta, repoIcon) : `${repoIcon} ${meta.name}`,
          description: `${refIcon} ${branchName}${opLabel}${repoPushLabel}${repoPullLabel}${activeLabel}`,
          action: () => this.showRepoBranchMenu(meta),
        });
      }

      if (gitMetas.length > 0) {
        await this.appendCommonBranches(items, gitMetas);
        await this.appendCommonTags(items, gitMetas);
      }
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: t('VersionDock: Git/SVN Menu'),
      matchOnDescription: true,
    });

    if (pick) await pick.action();
  }

  async showSvnMenu(repoId?: string): Promise<void> {
    const svnMetas = this.manager.getRepoMetas().filter(meta => meta.kind === 'svn');
    if (svnMetas.length === 0) {
      vscode.window.showInformationMessage(t('No SVN working copies found in this workspace.'));
      return;
    }

    let meta = repoId ? svnMetas.find(item => item.id === repoId) : undefined;
    if (!meta && svnMetas.length === 1) meta = svnMetas[0];
    if (!meta) {
      const picked = await vscode.window.showQuickPick(
        svnMetas.map(item => ({ label: formatRepoLabel(item), description: item.rootPath, id: item.id })),
        { title: t('Select SVN Working Copy'), placeHolder: t('Select an SVN working copy…') }
      );
      if (!picked) return;
      meta = svnMetas.find(item => item.id === picked.id);
    }
    if (meta) await this.showSvnRepoMenu(meta, { showBack: false });
  }

  private async pickSvnFileFromRepo(
    meta: RepoMeta,
    options: { title: string; conflictsOnly?: boolean; statusFilter?: (status: string) => boolean },
  ): Promise<string | undefined> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return undefined;

    type SvnFileItem = vscode.QuickPickItem & { filePath: string };
    const fileItems = new Map<string, SvnFileItem>();
    const addFile = (filePath: string, status?: string, description?: string): void => {
      const normalized = filePath.split(path.sep).join('/');
      const isConflictTarget = options.conflictsOnly && status === 'conflicted';
      if (!normalized || (normalized === '.' && !isConflictTarget)) return;
      const absolutePath = path.join(repo.rootPath, normalized);
      try {
        if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory() && !isConflictTarget) return;
      } catch {
        return;
      }
      if (!fileItems.has(normalized)) {
        fileItems.set(normalized, {
          label: normalized === '.' ? t('Repository root') : normalized,
          description: description ?? status,
          detail: status,
          filePath: normalized,
        });
      }
    };

    const status = await repo.getStatus().catch(() => undefined);
    for (const file of [...(status?.unstagedFiles ?? []), ...(status?.stagedFiles ?? [])]) {
      if (options.conflictsOnly && file.status !== 'conflicted') continue;
      if (options.statusFilter && !options.statusFilter(file.status)) continue;
      addFile(file.path, file.status);
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!options.conflictsOnly && activeUri?.scheme === 'file') {
      const relative = path.relative(repo.rootPath, activeUri.fsPath);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        addFile(relative, undefined, t('Active editor'));
      }
    }

    const items = Array.from(fileItems.values()).sort((left, right) => left.filePath.localeCompare(right.filePath));
    if (items.length === 0) {
      vscode.window.showInformationMessage(
        options.conflictsOnly
          ? t('No SVN conflicts found in {0}.', meta.name)
          : t('No SVN files available in {0}.', meta.name)
      );
      return undefined;
    }

    if (items.length === 1) return items[0].filePath;

    const picked = await vscode.window.showQuickPick(items, {
      title: options.title,
      placeHolder: t('Select an SVN file…'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?.filePath;
  }

  private showError(meta: { name: string }, error: unknown): void {
    if (isRemoteRepositoryCancelled(error)) return;
    const msg = error instanceof Error ? error.message : String(error);
    void showGitErrorMessage(t('VersionDock [{0}]: {1}', meta.name, msg), {
      onUnlocked: async () => {
        await this.manager.getAllStatusesFresh();
        await this.refresh();
      },
    });
  }

  private async markSvnResolvedWorking(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const filePath = await this.pickSvnFileFromRepo(meta, {
      title: t('Resolve Conflicts in {0}', meta.name),
      conflictsOnly: true,
    });
    if (!filePath) return;
    const svn = repo as typeof repo & { resolveWorking?: (filePath: string) => Promise<void> };
    try {
      await svn.resolveWorking?.(filePath);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: marked "{1}" as resolved.', meta.name, filePath));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  private async lockSvnFile(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const filePath = await this.pickSvnFileFromRepo(meta, {
      title: t('SVN Lock'),
      statusFilter: status => status !== 'untracked' && status !== 'deleted',
    });
    if (!filePath) return;
    const message = await vscode.window.showInputBox({
      title: t('SVN Lock'),
      prompt: t('Optional lock message'),
      placeHolder: t('Lock message'),
    });
    if (message === undefined) return;
    const svn = repo as typeof repo & { lock?: (paths: string[], message?: string) => Promise<string> };
    try {
      await svn.lock?.([filePath], message);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: locked "{1}".', meta.name, filePath));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  private async unlockSvnFile(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const filePath = await this.pickSvnFileFromRepo(meta, {
      title: t('SVN Unlock'),
      statusFilter: status => status !== 'untracked' && status !== 'deleted',
    });
    if (!filePath) return;
    const svn = repo as typeof repo & { unlock?: (paths: string[]) => Promise<string> };
    try {
      await svn.unlock?.([filePath]);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: unlocked "{1}".', meta.name, filePath));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  private async pickSvnIgnorePath(
    repo: { getStatus(): Promise<{ unstagedFiles: Array<{ status: string; path: string }> }> },
  ): Promise<string | undefined> {
    const status = await repo.getStatus().catch(() => undefined);
    const untrackedPaths = Array.from(new Set(
      (status?.unstagedFiles ?? [])
        .filter(file => file.status === 'untracked')
        .map(file => file.path),
    )).sort((left, right) => left.localeCompare(right));

    const customItem: SvnIgnoreCandidatePickItem = {
      label: `$(edit) ${t('Enter custom SVN ignore path...')}`,
      custom: true,
    };

    if (untrackedPaths.length > 0) {
      const picked = await vscode.window.showQuickPick<SvnIgnoreCandidatePickItem>(
        [
          ...untrackedPaths.map(filePath => ({ label: filePath, filePath })),
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          customItem,
        ],
        {
          title: t('Add SVN Ignore...'),
          placeHolder: t('Select an unversioned file or folder to ignore'),
          matchOnDescription: true,
        },
      );
      if (!picked) return undefined;
      if (!picked.custom) return picked.filePath;
    }

    return vscode.window.showInputBox({
      title: t('Add SVN Ignore...'),
      prompt: t('Enter a path relative to the repository root'),
      placeHolder: 'path/to/file-or-folder',
      validateInput: value => value.trim() ? undefined : t('SVN ignore target cannot be empty.'),
    });
  }

  private async manageSvnIgnore(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo || repo.kind !== 'svn') return;
    const svn = repo as unknown as Partial<SvnIgnoreRepo>;
    if (
      typeof svn.addIgnoreEntry !== 'function'
      || typeof svn.listIgnoreEntries !== 'function'
      || typeof svn.removeIgnoreEntries !== 'function'
    ) return;

    try {
      const entries = await svn.listIgnoreEntries();
      const actionItems: SvnIgnoreActionPickItem[] = [
        { label: `$(add) ${t('Add SVN Ignore...')}`, action: 'add' },
        ...(entries.length > 0
          ? [{ label: `$(trash) ${t('Remove SVN Ignore Entries...')}`, action: 'remove' } satisfies SvnIgnoreActionPickItem]
          : []),
      ];
      const action = await vscode.window.showQuickPick(actionItems, {
        title: t('Manage SVN Ignore...'),
        placeHolder: t('Choose an SVN ignore action'),
      });
      if (!action) return;

      if (action.action === 'add') {
        const entryPath = await this.pickSvnIgnorePath(repo);
        if (!entryPath) return;
        const result = await svn.addIgnoreEntry(entryPath);
        if (result.alreadyExists) {
          vscode.window.showInformationMessage(t('"{0}" is already in SVN ignore for {1}', result.entry, result.directoryPath || '.'));
        } else {
          vscode.window.showInformationMessage(t('Added "{0}" to SVN ignore for {1}', result.entry, result.directoryPath || '.'));
        }
        await this.refresh();
        return;
      }

      if (entries.length === 0) {
        vscode.window.showInformationMessage(t('No SVN ignore entries found.'));
        return;
      }

      const picks: SvnIgnorePickItem[] = entries.map(entry => ({
        label: entry.entry,
        description: entry.directoryPath || '.',
        detail: entry.fullPath,
        entry,
      }));
      const selected = await vscode.window.showQuickPick(picks, {
        title: t('Remove SVN Ignore Entries...'),
        placeHolder: t('Select SVN ignore entries to remove'),
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!selected || selected.length === 0) return;

      const confirm = await vscode.window.showWarningMessage(
        t('Remove selected SVN ignore entries?'),
        { modal: true },
        t('Remove'),
      );
      if (confirm !== t('Remove')) return;

      await svn.removeIgnoreEntries(selected.map(item => item.entry));
      vscode.window.showInformationMessage(t('Removed {0} SVN ignore entries.', selected.length));
      await this.refresh();
    } catch (e: unknown) {
      this.showError(meta, e);
    }
  }

  private async appendCommonBranches(
    items: Array<vscode.QuickPickItem & { action: () => Thenable<void> | void }>,
    metas: RepoMeta[]
  ): Promise<void> {
    const perRepo = await Promise.allSettled(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getBranches() : [];
      })
    );

    // Count local branches present in ALL repos
    const localCount = new Map<string, number>();
    // For remote branches: key = full "remote/branch" name, count per repo
    const remoteCount = new Map<string, number>();

    for (const r of perRepo) {
      if (r.status !== 'fulfilled') continue;
      const seenLocal = new Set<string>();
      const seenRemote = new Set<string>();
      for (const b of r.value) {
        if (b.isRemote) {
          // Keep full name (e.g. "upstream/main") so we preserve the remote name
          const fullName = b.name.startsWith('remotes/') ? b.name.slice('remotes/'.length) : b.name;
          if (!seenRemote.has(fullName)) {
            seenRemote.add(fullName);
            remoteCount.set(fullName, (remoteCount.get(fullName) ?? 0) + 1);
          }
        } else {
          if (!seenLocal.has(b.name)) {
            seenLocal.add(b.name);
            localCount.set(b.name, (localCount.get(b.name) ?? 0) + 1);
          }
        }
      }
    }

    const commonLocal = [...localCount.entries()]
      .filter(([, c]) => c === metas.length)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name]) => name);

    // commonRemote entries are full "remote/branch" strings (e.g. "origin/main", "upstream/main")
    const commonRemote = [...remoteCount.entries()]
      .filter(([, c]) => c === metas.length)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name]) => name);

    // Collect current HEAD names for highlighting
    const heads = new Set<string>();
    for (const r of perRepo) {
      if (r.status !== 'fulfilled') continue;
      const head = r.value.find(b => b.isHead && !b.isRemote);
      if (head) heads.add(head.name);
    }
    const headLabel = [...heads].join(', ');

    if (commonLocal.length > 0) {
      items.push({
        label: metas.length === 1 ? t('LOCAL BRANCHES') : t('COMMON LOCAL BRANCHES'),
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as typeof items[0]);
      for (const name of commonLocal) {
        const isCurrentSomewhere = heads.has(name);
        const icon = isCurrentSomewhere ? '$(check)' : isPrimaryBranch(name) ? '$(star)' : '$(git-branch)';
        items.push({
          label: `${icon} ${name}`,
          description: isCurrentSomewhere ? t('current') : '',
          action: () => this.showCommonBranchActionMenu(name, metas, isCurrentSomewhere, headLabel, false),
        });
      }
    }

    if (commonRemote.length > 0) {
      items.push({
        label: metas.length === 1 ? t('REMOTE BRANCHES') : t('COMMON REMOTE BRANCHES'),
        kind: vscode.QuickPickItemKind.Separator,
        action: async () => {},
      } as unknown as typeof items[0]);
      for (const fullName of commonRemote) {
        items.push({
          label: `$(cloud) ${fullName}`,
          description: '',
          action: () => this.showCommonBranchActionMenu(fullName, metas, false, headLabel, true),
        });
      }
    }
  }

  private async appendCommonTags(
    items: Array<vscode.QuickPickItem & { action: () => Thenable<void> | void }>,
    metas: RepoMeta[]
  ): Promise<void> {
    // Fetch tags and current branch for all repos in parallel
    const [perRepoTags, perRepoCurrent] = await Promise.all([
      Promise.allSettled(metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return { metaId: m.id, tags: repo ? await repo.getTags() : [] };
      })),
      Promise.allSettled(metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? repo.getCurrentBranch() : null;
      })),
    ]);

    // Active detached tags for highlighting
    const activeDetachedTags = new Set<string>();
    for (const r of perRepoCurrent) {
      if (r.status === 'fulfilled' && r.value?.detachedTag) {
        activeDetachedTags.add(r.value.detachedTag);
      }
    }

    // Build tag → set of repoIds that have it
    const tagRepoIds = new Map<string, string[]>();
    for (const r of perRepoTags) {
      if (r.status !== 'fulfilled') continue;
      const { metaId, tags } = r.value;
      const seen = new Set<string>();
      for (const t of tags) {
        if (!seen.has(t.name)) {
          seen.add(t.name);
          if (!tagRepoIds.has(t.name)) tagRepoIds.set(t.name, []);
          tagRepoIds.get(t.name)!.push(metaId);
        }
      }
    }

    // For multi-repo: only show tags present in ALL repos that responded.
    // fulfilled count tells us how many repos actually loaded tags.
    const fulfilledCount = perRepoTags.filter(r => r.status === 'fulfilled').length;
    const minCount = metas.length === 1 ? 1 : fulfilledCount;

    const tagNames = [...tagRepoIds.entries()]
      .filter(([, ids]) => ids.length >= minCount)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name]) => name);

    if (tagNames.length === 0) return;

    const sectionLabel = metas.length === 1 ? 'TAGS' : 'COMMON TAGS';
    items.push({
      label: sectionLabel,
      kind: vscode.QuickPickItemKind.Separator,
      action: async () => {},
    } as unknown as typeof items[0]);

    for (const tagName of tagNames) {
      const isActive = activeDetachedTags.has(tagName);
      // Only pass the repos that actually have this tag
      const tagMetas = metas.filter(m => tagRepoIds.get(tagName)?.includes(m.id));
      const icon = isActive ? '$(check)' : '$(tag)';
      items.push({
        label: `${icon} ${tagName}`,
          description: isActive ? t('current') : '',
        action: () => this.showCommonTagActionMenu(tagName, tagMetas),
      });
    }
  }

  private async showCommonTagActionMenu(
    tagName: string,
    metas: RepoMeta[],
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };

    // Get current branch names for label
    const currentBranchNames = await Promise.allSettled(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        return repo ? (await repo.getCurrentBranch()).name : '';
      })
    );
    const branchLabel = [...new Set(
      currentBranchNames
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter(Boolean)
    )].join(', ') || 'current branch';

    const remotes = await Promise.allSettled(metas.map(async m => {
      const repo = this.manager.getRepo(m.id);
      return repo ? repo.getRemotes() : [];
    }));
    const allRemotes = [...new Set(
      remotes
        .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
        .flatMap(r => r.value)
    )];

    const pushItems: ActionItem[] = allRemotes.map(remote => ({
      label: `$(cloud-upload) ${t('Push to "{0}"', remote)}`,
      action: async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing tag "{0}" to {1}…', tagName, remote), cancellable: false },
          async () => {
            const errors: string[] = [];
            for (const meta of metas) {
              const repo = this.manager.getRepo(meta.id);
              if (!repo) continue;
              try { await repo.pushTag(tagName, remote); } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
            }
            if (errors.length > 0) {
              vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
            } else {
              vscode.window.showInformationMessage(t('VersionDock: tag "{0}" pushed to "{1}" in {2} repos.', tagName, remote, metas.length));
            }
          }
        );
      },
    }));

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(arrow-right) ${t('Checkout')}`,
        description: t('Checkout tag "{0}" in all repos (detached HEAD)', tagName),
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Checking out tag "{0}"…', tagName), cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try { await repo.checkoutTag(tagName); } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
              }
              if (errors.length > 0) vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
              else vscode.window.showInformationMessage(t('VersionDock: checked out tag "{0}" in {1} repos.', tagName, metas.length));
            }
          );
          await this.refresh();
        },
      },
      {
        label: `$(git-merge) ${t('Merge "{0}" into "{1}"', tagName, branchLabel)}`,
        action: async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Merging tag "{0}"…', tagName), cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try { await repo.mergeTag(tagName); } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
              }
              if (errors.length > 0) vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
              else vscode.window.showInformationMessage(t('VersionDock: merged tag "{0}" in {1} repos.', tagName, metas.length));
            }
          );
          await this.refresh();
        },
      },
      ...pushItems,
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) ${t('Delete tag')}`,
        description: t('Delete tag "{0}" in all repos', tagName),
        action: async () => {
          const pick = await vscode.window.showWarningMessage(
            metas.length === 1
              ? t('Delete tag "{0}" in {1} repository?', tagName, metas.length)
              : t('Delete tag "{0}" in {1} repositories?', tagName, metas.length),
            { modal: true }, t('Delete Local'), t('Delete on Remote'), t('Delete Local and Remote')
          );
          if (!pick) return;
          const deleteLocal = pick !== t('Delete on Remote');
          const deleteRemote = pick === t('Delete on Remote') || pick === t('Delete Local and Remote');
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Deleting tag "{0}"…', tagName), cancellable: false },
            async () => {
              const errors: string[] = [];
              for (const meta of metas) {
                const repo = this.manager.getRepo(meta.id);
                if (!repo) continue;
                try {
                  if (deleteLocal) await repo.deleteTag(tagName);
                  if (deleteRemote) {
                    const remotes = await repo.getRemotes().catch(() => [] as string[]);
                    for (const remote of remotes) {
                      await repo.deleteTagRemote(tagName, remote).catch(() => {});
                    }
                  }
                } catch (e: unknown) { errors.push(`${meta.name}: ${String(e)}`); }
              }
              if (errors.length > 0) vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
              else vscode.window.showInformationMessage(t('VersionDock: deleted tag "{0}" in {1} repos.', tagName, metas.length));
            }
          );
          await this.refresh();
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: t('Tag: {0}', tagName),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async showCommonBranchActionMenu(
    branchName: string,
    metas: RepoMeta[],
    isCurrent: boolean,
    currentBranchName: string,
    isRemote: boolean,
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(arrow-right) ${t('Checkout')}`,
        description: t('Switch all repos to {0}', branchName),
        action: () => this.checkoutBranchAllRepos(branchName, metas),
      },
      {
        label: `$(add) ${t("New branch from '{0}'…", branchName)}`,
        action: () => this.newBranchFrom(branchName, metas),
      },
      ...(!isRemote ? [{
        label: `$(cloud-download) ${t('Update (Pull)')}`,
        description: t('Pull {0} in all repos', branchName),
        action: () => this.pullBranchAllRepos(branchName, metas),
      },
      {
        label: `$(edit) ${t('Rename…')}`,
        action: () => this.renameBranchAllRepos(branchName, metas),
      }] satisfies ActionItem[] : []),
    ];

    if (!isCurrent) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(git-compare) ${t("Compare '{0}' with '{1}'", currentBranchName, branchName)}`,
          action: () => this.compareBranchAllRepos(branchName, metas),
        },
        {
          label: `$(repo-forked) ${t("Rebase '{0}' onto '{1}'", currentBranchName, branchName)}`,
          action: () => this.rebaseAllRepos(branchName, metas),
        },
        {
          label: `$(git-merge) ${t("Merge '{0}' into '{1}'", branchName, currentBranchName)}`,
          action: () => this.mergeBranchAllRepos(branchName, metas),
        },
      );
    }

    if (!isRemote) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(trash) ${t('Delete…')}`,
          action: () => this.deleteBranchAllRepos(branchName, metas),
        },
      );
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: t('{0}', branchName),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  async push(): Promise<void> {
    await this.pushMenu(this.manager.getRepoMetas());
  }

  private async pushMenu(metas: RepoMeta[]): Promise<void> {
    type RepoRemoteItem = vscode.QuickPickItem & { repoId: string; remote?: string; repoLabel: string };
    const allMetas = this.manager.getRepoMetas();
    const gitMetas = allMetas.filter(meta => meta.kind !== 'svn');
    const showRepoKinds = gitMetas.length > 0 && gitMetas.length < allMetas.length;

    // Collect all repo+remote combinations
    const items: RepoRemoteItem[] = [];
    for (const meta of metas) {
      if (meta.kind === 'svn') continue;
      const repo = this.manager.getRepo(meta.id);
      if (!repo) continue;
      const remotes = await repo.getRemotes().catch(() => [] as string[]);
      const targets = remotes.length > 0 ? remotes : [undefined];
      for (const remote of targets) {
        const repoLabel = showRepoKinds ? formatRepoLabel(meta) : meta.name;
        items.push({
          label: `$(cloud-upload) ${repoLabel}`,
          description: remote ? `→ ${remote}` : t('No remote — create and push'),
          repoId: meta.id,
          remote,
          repoLabel,
        });
      }
    }

    if (items.length === 0) {
      vscode.window.showWarningMessage(t('VersionDock: No remotes configured in any repository.'));
      return;
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: t('VersionDock — Push: select repository and remote'),
      matchOnDescription: true,
    }) as RepoRemoteItem | undefined;

    if (!pick) return;

    const repo = this.manager.getRepo(pick.repoId);
    if (!repo) return;

    await this.withOperationProgress(async () => {
      const pushResult = await runPushWithProtection(repo, {
        repoName: pick.repoLabel,
        remote: pick.remote,
        logger: this.logger,
      });
      if (pushResult.success) {
        if (!pushResult.rebased && !pushResult.forced) {
          vscode.window.showInformationMessage(pick.remote
            ? t('VersionDock [{0}]: pushed to \'{1}\' successfully.', pick.repoLabel, pick.remote)
            : t('VersionDock [{0}]: remote created and branch pushed successfully.', pick.repoLabel));
        }
      } else if (!pushResult.cancelled) {
        vscode.window.showErrorMessage(t('VersionDock: Push failed — {0}', String(pushResult.error)));
      }
    });
  }

  private async abortOperation(meta: RepoMeta, state: 'merge' | 'rebase'): Promise<void> {
    await this.abortOperations([{ meta, state }]);
  }

  private async abortOperations(items: AbortOperationTarget[]): Promise<void> {
    await this.withOperationProgress(async () => {
      const result = await runAbortOperationFlow(this.manager, items);
      if (result.ok) {
        vscode.window.showInformationMessage(
          t('VersionDock [{0}]: {1} aborted successfully.', result.target.meta.name, getAbortOperationName(result.target.state))
        );
      } else if (!('cancelled' in result)) {
        vscode.window.showErrorMessage(result.error);
      }
    });
  }

  async fetchAll(): Promise<void> {
    await this.withOperationProgress(async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('VersionDock: Fetching all remotes…'),
          cancellable: false,
        },
        async () => {
          await this.manager.fetchAll();
        }
      );
    });
    vscode.window.showInformationMessage(t('VersionDock: Fetch complete.'));
  }

  async updateProject(): Promise<void> {
    const metas = this.manager.getRepoMetas();
    const hasGitRepos = metas.some(meta => meta.kind !== 'svn');
    let useRebase = false;

    if (hasGitRepos) {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: `$(git-merge) ${t('Merge incoming changes into the current branch')}`,
            rebase: false,
          },
          {
            label: `$(repo-forked) ${t('Rebase the current branch on top of incoming changes')}`,
            rebase: true,
          },
        ],
        { title: t('Update Project — Strategy') }
      ) as { label: string; rebase: boolean } | undefined;

      if (!pick) return;
      useRebase = pick.rebase;
    }

    let results: Awaited<ReturnType<UpdateSummaryService['runAll']>> = [];
    await this.withOperationProgress(async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('VersionDock: Updating all projects…'),
          cancellable: false,
        },
        async () => {
          results = await this.updateSummaryService.runAll(metas.map(meta => ({
            repoId: meta.id,
            execute: repo => meta.kind === 'svn'
              ? repo.pull()
              : useRebase
                ? repo.pullRebase()
                : repo.pull(),
          })));
        }
      );
      this.manager.notifyBranchesChanged();
      await this.updateSummaryService.notify(results);
    });
  }

  private async newBranch(metas: RepoMeta[]): Promise<void> {
    // Step 1: branch name
    const branchName = await vscode.window.showInputBox({
      title: t('New Branch — Name'),
      prompt: t('Enter the new branch name'),
      validateInput: v => (v.trim() ? undefined : t('Branch name cannot be empty')),
    });
    if (!branchName) return;

    // Step 2: base branch (from any repo)
    const allBranches = await this.manager.getAllBranches();
    const localBranches = allBranches.filter(b => !b.isRemote);
    const uniqueBaseNames = [...new Set(localBranches.map(b => b.name))].sort();
    const currentHeads = [...new Set(localBranches.filter(b => b.isHead).map(b => b.name))];
    const currentLabel = currentHeads.length > 0 ? currentHeads.join(', ') : 'current branch';

    const BASE_CURRENT = '__current__';
    const baseItems: Array<vscode.QuickPickItem & { value: string }> = [
      { label: `$(git-branch) ${currentLabel}`, description: t('Current HEAD of each repo'), value: BASE_CURRENT },
      ...uniqueBaseNames.map(n => ({ label: `$(git-branch) ${n}`, description: n, value: n })),
    ];
    const basePick = await vscode.window.showQuickPick(baseItems, {
      title: t('New Branch — Base'),
      placeHolder: t('Select the base branch'),
    }) as (typeof baseItems[number]) | undefined;
    if (!basePick) return;
    const baseFrom = basePick.value === BASE_CURRENT ? undefined : basePick.value;

    // Step 3: target repos
    const repoItems = metas.map(m => ({
      label: formatRepoLabel(m, '$(root-folder)'),
      description: m.rootPath,
      picked: true,
      repoId: m.id,
    }));
    const pickedRepos = await vscode.window.showQuickPick(repoItems, {
      title: t('New Branch — Repositories'),
      placeHolder: t('Select repos to create the branch in'),
      canPickMany: true,
    });
    if (!pickedRepos || pickedRepos.length === 0) return;

    // Step 4: checkout?
    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${t('No, just create the branch')}`, value: false },
      ],
      { title: t('New Branch — Checkout?') }
    );
    if (!checkoutPick) return;
    const doCheckout = (checkoutPick as { value: boolean }).value;

    // Execute
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Creating branch "{0}"…', branchName), cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const item of pickedRepos) {
          const repo = this.manager.getRepo((item as typeof repoItems[number]).repoId);
          if (!repo) continue;
          try {
            if (doCheckout) {
              await repo.checkout(branchName, true, baseFrom);
            } else {
              await repo.createBranch(branchName, baseFrom);
            }
          } catch (e: unknown) {
            errors.push(`${item.label}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(
            t('VersionDock: Branch "{0}" created in {1} repos.', branchName, pickedRepos.length)
          );
        }
      }
    );
    await this.refresh();
  }

  private async showRepoBranchMenu(meta: RepoMeta, options: { showBack?: boolean } = { showBack: true }): Promise<void> {
    if (meta.kind === 'svn') {
      await this.showSvnRepoMenu(meta, options);
      return;
    }
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const [branches, currentBranch, tags, operationState, lastCommitsMap] = await Promise.all([
      repo.getBranches(),
      repo.getCurrentBranch(),
      repo.getTags(),
      repo.getMergeRebaseState(),
      repo.getBranchLastCommits().catch(() => new Map<string, { message: string; relativeDate: string; author: string }>()),
    ]);
    const local = branches.filter(b => !b.isRemote);
    const remote = branches.filter(b => b.isRemote);
    const effectiveBranchName = currentBranch.detachedTag ?? currentBranch.detachedHash ?? currentBranch.name;
    const isDetached = !!currentBranch.detachedTag || !!currentBranch.detachedHash || currentBranch.name === 'HEAD';

    type BranchItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };

    const items: BranchItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showMenu(),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...(isDetached ? [
        {
          label: `$(plus) ${t('Create Branch from HEAD ({0})…', effectiveBranchName)}`,
          description: t('Fix detached HEAD — create a branch to safely commit changes'),
          action: () => this.newBranchSingleRepo(meta),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ] : []),
      {
        label: `$(add) ${t('New Branch…')}`,
        description: t('Create a new branch in {0}', meta.name),
        action: () => this.newBranchSingleRepo(meta),
      },
      {
        label: `$(remote-explorer) ${t('Manage Remotes…')}`,
        description: t('Add, remove, or edit remote repositories'),
        action: () => this.showRepoRemotesMenu(meta),
      },
      ...(operationState ? [
        {
          label: operationState === 'merge'
            ? `$(error) ${t('Abort Merge')}`
            : `$(error) ${t('Abort Rebase')}`,
          description: operationState === 'merge'
            ? t('Merge in progress — abort and restore previous state')
            : t('Rebase in progress — abort and restore previous state'),
          action: () => this.abortOperation(meta, operationState),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ] : []),
    ];

    // Recent branches group
    const recent = this.recentBranches.get(meta.id) ?? [];
    const validRecent = recent
      .map(name => local.find(b => b.name === name))
      .filter((b): b is typeof local[0] => Boolean(b && !b.isHead));

    if (validRecent.length > 0) {
      items.push({ label: t('RECENT'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      for (const b of validRecent) {
        const remoteNames = new Set(remote.map(r => r.name.replace(/^[^/]+\//, '')));
        const hasRemote = remoteNames.has(b.name);
        const hasUnpushed = !hasRemote || (b.aheadBehind?.ahead ?? 0) > 0;
        const commitInfo = lastCommitsMap.get(b.name);
        const commitDetail = commitInfo?.message
          ? `$(git-commit) ${commitInfo.message} · ${commitInfo.relativeDate}`
          : undefined;
        items.push({
          label: `$(history) ${b.name}`,
          description: b.aheadBehind ? `↑${b.aheadBehind.ahead} ↓${b.aheadBehind.behind}` : '',
          detail: commitDetail,
          action: () => this.showSingleBranchActionMenu(b.name, meta, false, false, hasUnpushed, effectiveBranchName),
        });
      }
    }

    items.push(
      { label: t('LOCAL'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...local.map(b => {
        const primary = isPrimaryBranch(b.name);
        const icon = b.isHead ? '$(check)' : primary ? '$(star)' : '$(git-branch)';
        const remoteNames = new Set(remote.map(r => r.name.replace(/^[^/]+\//, '')));
        const hasRemote = b.isHead ? !!currentBranch.upstream : remoteNames.has(b.name);
        const hasUnpushed = !hasRemote || (b.aheadBehind?.ahead ?? 0) > 0;
        const commitInfo = lastCommitsMap.get(b.name);
        const commitDetail = commitInfo?.message
          ? `$(git-commit) ${commitInfo.message} · ${commitInfo.relativeDate}`
          : undefined;
        return {
          label: `${icon} ${b.name}`,
          description: b.aheadBehind ? `↑${b.aheadBehind.ahead} ↓${b.aheadBehind.behind}` : (b.isHead ? t('current') : ''),
          detail: commitDetail,
          action: () => this.showSingleBranchActionMenu(b.name, meta, b.isHead, false, hasUnpushed, effectiveBranchName),
        };
      }),
      { label: t('REMOTE'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...remote.map(b => {
        const remotePrefix = b.remoteName ? `${b.remoteName}/` : '';
        const branchName = remotePrefix && b.name.startsWith(remotePrefix)
          ? b.name.slice(remotePrefix.length)
          : b.name.slice(b.name.indexOf('/') + 1);
        const primary = isPrimaryBranch(branchName);
        const icon = primary ? '$(star)' : '$(cloud)';
        const commitInfo = lastCommitsMap.get(b.name);
        const commitDetail = commitInfo?.message
          ? `$(git-commit) ${commitInfo.message} · ${commitInfo.relativeDate}`
          : undefined;
        return {
          label: `${icon} ${b.name}`,
          description: '',
          detail: commitDetail,
          action: () => this.showSingleBranchActionMenu(b.name, meta, false, true, false, effectiveBranchName),
        };
      }),
    );

    if (tags.length > 0) {
      items.push({ label: t('TAGS'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      for (const tag of tags) {
        const isActiveTag = currentBranch.detachedTag === tag.name;
        const icon = isActiveTag ? '$(check)' : '$(tag)';
        items.push({
          label: `${icon} ${tag.name}`,
          description: isActiveTag ? t('current') : tag.hash,
          action: () => this.showSingleTagActionMenu(tag.name, meta, effectiveBranchName, isDetached),
        });
      }
    }

    if (meta.isSubmodule) {
      items.push({ label: t('SUBMODULE'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      items.push({
        label: `$(repo-sync) ${t('Update')}`,
        description: `git submodule update ${meta.submodulePath ?? ''}`,
        action: () => vscode.commands.executeCommand('versiondock.submodule.update', meta.id),
      });
      items.push({
        label: `$(repo-sync) ${t('Update (recursive)')}`,
        description: t('git submodule update --init --recursive'),
        action: () => vscode.commands.executeCommand('versiondock.submodule.updateRecursive', meta.id),
      });
      items.push({
        label: `$(add) ${t('Init')}`,
        description: t('Initialize this submodule'),
        action: () => vscode.commands.executeCommand('versiondock.submodule.init', meta.id),
      });
      items.push({
        label: `$(trash) ${t('Deinit')}`,
        description: t('Deinitialize this submodule'),
        action: () => vscode.commands.executeCommand('versiondock.submodule.deinit', meta.id),
      });
      items.push({
        label: `$(link-external) ${t('Open in New Window')}`,
        description: t('Open submodule folder in a separate VS Code window'),
        action: () => vscode.commands.executeCommand('versiondock.submodule.openInNewWindow', meta.id),
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: t('{0} — Branches', meta.name),
      matchOnDescription: true,
      matchOnDetail: true,
    }) as BranchItem | undefined;

    if (pick) await pick.action();
  }

  private async showSvnRepoMenu(meta: RepoMeta, options: { showBack?: boolean } = { showBack: true }): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const [current, status] = await Promise.all([
      repo.getCurrentBranch().catch(() => undefined),
      repo.getStatus().catch(() => undefined),
    ]);
    const hasConflicts = (status?.conflictCount ?? 0) > 0
      || [...(status?.unstagedFiles ?? []), ...(status?.stagedFiles ?? [])].some(file => file.status === 'conflicted');
    const hasAbortableMerge = status?.operationState === 'merge';
    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };
    const items: ActionItem[] = [
      ...(options.showBack === false ? [] : [
        { label: `$(arrow-left) ${t('Back')}`, action: () => this.showMenu() },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ]),
      {
        label: `$(cloud-download) ${t('Update Project…')}`,
        description: t('Run svn update for {0}', meta.name),
        action: async () => {
          const result = await this.updateSummaryService.run({ repoId: meta.id, execute: target => target.pull() });
          this.manager.notifyBranchesChanged();
          await this.updateSummaryService.notify([result]);
          await this.refresh();
        },
      },
      {
        label: `$(git-commit) ${t('Commit')}`,
        description: t('Open Commit panel'),
        action: () => this.commitPanelReveal(),
      },
      {
        label: `$(history) ${t('Log')}`,
        description: t('Open VCS Log panel'),
        action: async () => { await vscode.commands.executeCommand('versiondock.openLog'); },
      },
      ...(hasConflicts ? [
        {
          label: `$(git-merge) ${t('Resolve Conflicts')}`,
          description: t('Open the conflicts panel to resolve files'),
          action: async () => { await vscode.commands.executeCommand('versiondock.openConflicts'); },
        },
        ...(hasAbortableMerge ? [{
          label: `$(error) ${t('Abort Merge')}`,
          description: t('SVN conflicts detected — revert conflicted files'),
          action: () => this.abortOperation(meta, 'merge'),
        }] : []),
        {
          label: `$(check) ${t('Mark Resolved (Working)…')}`,
          action: () => this.markSvnResolvedWorking(meta),
        },
      ] : []),
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(tools) ${t('SVN Cleanup')}`,
        action: () => vscode.commands.executeCommand('versiondock.svn.cleanup', meta.id),
      },
      {
        label: `$(lock) ${t('SVN Lock')}`,
        description: t('Select an SVN file…'),
        action: () => this.lockSvnFile(meta),
      },
      {
        label: `$(unlock) ${t('SVN Unlock')}`,
        description: t('Select an SVN file…'),
        action: () => this.unlockSvnFile(meta),
      },
      {
        label: `$(exclude) ${t('Manage SVN Ignore...')}`,
        action: () => this.manageSvnIgnore(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(link) ${t('SVN Relocate…')}`,
        description: t('Change repository root URL for this working copy'),
        action: () => vscode.commands.executeCommand('versiondock.svn.relocate', meta.id),
      },
      {
        label: `$(git-branch) ${t('SVN Switch…')}`,
        description: current ? current.name : undefined,
        action: () => vscode.commands.executeCommand('versiondock.svn.switch', meta.id),
      },
      {
        label: `$(git-branch-create) ${t('SVN Create Branch…')}`,
        action: () => vscode.commands.executeCommand('versiondock.svn.createBranch', meta.id),
      },
      {
        label: `$(tag) ${t('SVN Create Tag…')}`,
        action: () => vscode.commands.executeCommand('versiondock.svn.createTag', meta.id),
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: t('VersionDock — SVN: {0}', meta.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;
    if (pick) await pick.action();
  }

  private async showSingleTagActionMenu(
    tagName: string,
    meta: RepoMeta,
    currentBranchName: string,
    isDetached = false,
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };

    const remotes = await repo.getRemotes().catch(() => [] as string[]);
    const pushItems: ActionItem[] = remotes.map(r => ({
      label: `$(cloud-upload) ${t('Push to "{0}"', r)}`,
      action: async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing tag "{0}" to {1}…', tagName, r), cancellable: false },
          async () => {
            try {
              await repo.pushTag(tagName, r);
              vscode.window.showInformationMessage(t('VersionDock [{0}]: tag "{1}" pushed to "{2}".', meta.name, tagName, r));
            } catch (e: unknown) {
              this.showError(meta, e);
            }
          }
        );
      },
    }));

    const mergeItem: ActionItem = {
      label: `$(git-merge) ${t('Merge "{0}" into "{1}"', tagName, currentBranchName)}`,
      action: async () => {
        try {
          await repo.mergeTag(tagName);
          vscode.window.showInformationMessage(t('VersionDock [{0}]: merged tag "{1}".', meta.name, tagName));
        } catch (e: unknown) {
          this.showError(meta, e);
        }
        await this.refresh();
      },
    };

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(arrow-right) ${t('Checkout')}`,
        description: t('Checkout tag "{0}" (detached HEAD)', tagName),
        action: async () => {
          try {
            await repo.checkoutTag(tagName);
            vscode.window.showInformationMessage(t('VersionDock [{0}]: checked out tag "{1}" (detached HEAD).', meta.name, tagName));
          } catch (e: unknown) {
            this.showError(meta, e);
          }
          await this.refresh();
        },
      },
      ...(isDetached ? [] : [mergeItem]),
      ...pushItems,
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) ${t('Delete tag')}`,
        description: t('Delete tag "{0}"', tagName),
        action: async () => {
          const pick = await vscode.window.showWarningMessage(
            t('Delete tag "{0}" in {1}?', tagName, meta.name),
            { modal: true }, t('Delete Local'), t('Delete on Remote'), t('Delete Local and Remote')
          );
          if (!pick) return;
          const deleteLocal = pick !== t('Delete on Remote');
          const deleteRemote = pick === t('Delete on Remote') || pick === t('Delete Local and Remote');
          try {
            if (deleteLocal) await repo.deleteTag(tagName);
            if (deleteRemote) {
              const remotes = await repo.getRemotes().catch(() => [] as string[]);
              if (remotes.length === 0) {
                vscode.window.showWarningMessage(t('VersionDock [{0}]: no remotes configured.', meta.name));
              } else {
                const remote = remotes.length === 1
                  ? remotes[0]
                  : (await vscode.window.showQuickPick(remotes, { title: t('Delete "{0}" from remote', tagName) }));
                if (remote) await repo.deleteTagRemote(tagName, remote);
              }
            }
            vscode.window.showInformationMessage(t('VersionDock [{0}]: tag "{1}" deleted.', meta.name, tagName));
          } catch (e: unknown) {
            this.showError(meta, e);
          }
          await this.refresh();
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: t('Tag: {0} — {1}', tagName, meta.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async showSingleBranchActionMenu(
    branchName: string,
    meta: RepoMeta,
    isCurrent: boolean,
    isRemote: boolean,
    hasUnpushed: boolean,
    currentBranchName: string,
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };
    const repo = this.manager.getRepo(meta.id);
    const operationState = repo ? await repo.getMergeRebaseState() : null;

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ...(operationState ? [
        {
          label: operationState === 'merge'
            ? `$(error) ${t('Abort Merge')}`
            : `$(error) ${t('Abort Rebase')}`,
          description: operationState === 'merge'
            ? t('Merge in progress — abort and restore previous state')
            : t('Rebase in progress — abort and restore previous state'),
          action: () => this.abortOperation(meta, operationState),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      ] : []),
      {
        label: `$(arrow-right) ${t('Checkout')}`,
        action: () => this.checkoutSingleRepo(branchName, meta),
      },
      {
        label: `$(add) ${t("New branch from '{0}'…", branchName)}`,
        action: () => this.newBranchFromSingleRepo(branchName, meta),
      },
      ...(!isRemote ? [{
        label: `$(cloud-download) ${t('Update (Pull)')}`,
        action: () => this.pullSingleRepo(meta, (!isCurrent && !isRemote) ? branchName : undefined),
      },
      {
        label: `$(edit) ${t('Rename…')}`,
        action: () => this.renameBranchSingleRepo(branchName, meta),
      }] satisfies ActionItem[] : []),
    ];

    if (hasUnpushed && !isRemote) {
      items.push({
        label: `$(cloud-upload) ${t('Push')}`,
        action: () => this.pushSingleRepo(meta),
      });
    }

    if (!isCurrent) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(git-compare) ${t("Compare '{0}' with '{1}'", currentBranchName, branchName)}`,
          action: () => this.compareSingleRepo(branchName, meta),
        },
        {
          label: `$(repo-forked) ${t("Rebase '{0}' onto '{1}'", currentBranchName, branchName)}`,
          action: () => this.rebaseSingleRepo(branchName, meta),
        },
        {
          label: `$(git-merge) ${t("Merge '{0}' into '{1}'", branchName, currentBranchName)}`,
          action: () => this.mergeSingleRepo(branchName, meta),
        },
      );
      if (!isRemote) {
        items.push(
          { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
          {
            label: `$(trash) ${t('Delete…')}`,
            action: () => this.deleteSingleRepo(branchName, meta),
          },
        );
      }
    }

    if (isRemote) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
        {
          label: `$(repo-forked) ${t("Pull into '{0}' using Rebase", currentBranchName)}`,
          action: () => this.pullRemoteIntoCurrentSingleRepo(branchName, meta, true),
        },
        {
          label: `$(git-merge) ${t("Pull into '{0}' using Merge", currentBranchName)}`,
          action: () => this.pullRemoteIntoCurrentSingleRepo(branchName, meta, false),
        },
      );
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: t('{0} — {1}', branchName, meta.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async newBranchSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const branchName = await vscode.window.showInputBox({
      title: t('New Branch in {0}', meta.name),
      prompt: t('Enter the new branch name'),
      validateInput: v => (v.trim() ? undefined : t('Branch name cannot be empty')),
    });
    if (!branchName) return;

    const branches = await repo.getBranches();
    const localBranches = branches.filter(b => !b.isRemote);
    const localNames = localBranches.map(b => b.name);
    const currentHead = localBranches.find(b => b.isHead)?.name ?? t('current branch');

    const BASE_CURRENT = '__current__';
    const baseItems: Array<vscode.QuickPickItem & { value: string }> = [
      { label: `$(git-branch) ${currentHead}`, description: t('Current HEAD'), value: BASE_CURRENT },
      ...localNames.map(n => ({ label: `$(git-branch) ${n}`, description: n, value: n })),
    ];
    const basePick = await vscode.window.showQuickPick(baseItems, {
      title: t('New Branch in {0} — Base', meta.name),
      placeHolder: t('Select the base branch'),
    }) as (typeof baseItems[number]) | undefined;
    if (!basePick) return;
    const baseFrom = basePick.value === BASE_CURRENT ? undefined : basePick.value;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${t('No, just create the branch')}`, value: false },
      ],
      { title: t('New Branch in {0} — Checkout?', meta.name) }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('VersionDock: Creating branch "{0}"…', branchName),
        cancellable: false,
      },
      async () => {
        try {
          if (checkoutPick.value) {
            await repo.checkout(branchName, true, baseFrom);
          } else {
            await repo.createBranch(branchName, baseFrom);
          }
          vscode.window.showInformationMessage(
            checkoutPick.value
              ? t('VersionDock [{0}]: branch "{1}" created and checked out.', meta.name, branchName)
              : t('VersionDock [{0}]: branch "{1}" created.', meta.name, branchName)
          );
        } catch (e: unknown) {
          this.showError(meta, e);
        }
      }
    );
    await this.refresh();
  }

  private async checkoutSingleRepo(branchName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Checking out "{0}"…', branchName), cancellable: false },
      async () => {
        try {
          await repo.checkout(branchName);
          this.recordRecentBranch(meta.id, branchName);
          vscode.window.showInformationMessage(t('VersionDock [{0}]: switched to "{1}"', meta.name, branchName));
        } catch (e: unknown) {
          const handled = await this.handleDirtyCheckout(repo, meta, branchName, e);
          if (!handled) vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', meta.name, String(e)));
        }
      }
    );
    await this.refresh();
  }

  private async handleDirtyCheckout(
    repo: import('../git/GitService').GitService,
    meta: RepoMeta,
    branchName: string,
    originalError: unknown
  ): Promise<boolean> {
    const msg = String(originalError);
    // Only offer the menu for "dirty working tree" errors
    if (!msg.includes('Your local changes') && !msg.includes('local changes') && !msg.includes('overwritten by checkout')) {
      return false;
    }

    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> };
    const items: ActionItem[] = [
      {
        label: `$(archive) ${t('Stash and checkout')}`,
        detail: t('Save changes to stash, then switch to the branch'),
        action: async () => {
          await repo.runWithGitWriteLock(async () => {
            await repo.stashPush(`WIP before checkout to ${branchName}`);
            await repo.checkout(branchName);
          });
          vscode.window.showInformationMessage(
            t('VersionDock [{0}]: changes stashed, switched to "{1}"', meta.name, branchName)
          );
        },
      },
      {
        label: `$(arrow-right) ${t('Bring changes to new branch')}`,
        detail: t('Carry uncommitted changes into the new branch'),
        action: async () => {
          await repo.runWithGitWriteLock(async () => {
            await repo.stashPush(`WIP migrating to ${branchName}`);
            await repo.checkout(branchName);
            await repo.stashPop();
          });
          vscode.window.showInformationMessage(
            t('VersionDock [{0}]: changes migrated to "{1}"', meta.name, branchName)
          );
        },
      },
      {
        label: `$(warning) ${t('Force checkout')}`,
        detail: t('Discard local changes and switch to the branch'),
        action: async () => {
          await repo.checkoutForce(branchName);
          vscode.window.showInformationMessage(
            t('VersionDock [{0}]: force checkout to "{1}" (changes discarded)', meta.name, branchName)
          );
        },
      },
      {
        label: `$(close) ${t('Cancel')}`,
        detail: '',
        action: async () => { /* no-op */ },
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: t('VersionDock [{0}]: Uncommitted changes', meta.name),
      placeHolder: t('Choose how to handle local changes before switching to "{0}"', branchName),
      ignoreFocusOut: true,
    });

    if (pick) await pick.action();
    return true;
  }

  private async checkoutBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    // Find which repos have this branch
    const results = await Promise.allSettled(
      metas.map(async m => {
        const repo = this.manager.getRepo(m.id);
        if (!repo) return { meta: m, hasBranch: false };
        const branches = await repo.getBranches();
        const found = branches.find(branch => branch.name === branchName);
        return { meta: m, hasBranch: !!found, isRemote: found?.isRemote ?? false, fullName: found?.name };
      })
    );

    const candidates = results
      .filter((r): r is PromiseFulfilledResult<{ meta: RepoMeta; hasBranch: boolean; isRemote: boolean; fullName?: string }> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(r => r.hasBranch);

    if (candidates.length === 0) {
      vscode.window.showWarningMessage(t('VersionDock: Branch "{0}" not found in any repository.', branchName));
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Checking out "{0}"…', branchName), cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const { meta, fullName } of candidates) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.checkout(fullName ?? branchName);
            this.recordRecentBranch(meta.id, branchName);
          } catch (e: unknown) {
            const handled = await this.handleDirtyCheckout(repo, meta, fullName ?? branchName, e);
            if (!handled) errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(
            t('VersionDock: Checked out "{0}" in {1} repos.', branchName, candidates.length)
          );
        }
      }
    );
    await this.refresh();
  }

  // ── Single-repo branch actions ──────────────────────────────────────────

  private async newBranchFromSingleRepo(fromBranch: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const branchName = await vscode.window.showInputBox({
      title: t("New Branch from '{0}' in {1}", fromBranch, meta.name),
      prompt: t('Enter the new branch name'),
      validateInput: v => (v.trim() ? undefined : t('Branch name cannot be empty')),
    });
    if (!branchName) return;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${t('No, just create the branch')}`, value: false },
      ],
      { title: t('New Branch — Checkout?') }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('VersionDock: Creating branch "{0}"…', branchName),
        cancellable: false,
      },
      async () => {
        try {
          if (checkoutPick.value) {
            await repo.checkout(branchName, true, fromBranch);
          } else {
            await repo.createBranch(branchName, fromBranch);
          }
          vscode.window.showInformationMessage(
            checkoutPick.value
              ? t('VersionDock [{0}]: branch "{1}" created and checked out.', meta.name, branchName)
              : t('VersionDock [{0}]: branch "{1}" created.', meta.name, branchName)
          );
        } catch (e: unknown) {
          this.showError(meta, e);
        }
      }
    );
    await this.refresh();
  }

  private async pullSingleRepo(meta: RepoMeta, branchName?: string): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    let result: Awaited<ReturnType<UpdateSummaryService['run']>> | undefined;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Pulling…', meta.name), cancellable: false },
      async () => {
        result = await this.updateSummaryService.run({
          repoId: meta.id,
          branchName,
          execute: target => branchName ? target.pullBranch(branchName) : target.pull(),
        });
      }
    );
    if (result?.tracked) await this.updateSummaryService.notify([result]);
    else if (result?.ok) vscode.window.showInformationMessage(t('VersionDock [{0}]: pulled successfully.', meta.name));
    else if (result) vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', meta.name, result.error ?? t('Unknown error')));
    this.manager.notifyBranchesChanged();
    await this.refresh();
  }

  private async renameBranchSingleRepo(oldName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const newName = await vscode.window.showInputBox({
      title: t("Rename branch '{0}' in {1}", oldName, meta.name),
      value: oldName,
      validateInput: v => (v.trim() ? undefined : t('Branch name cannot be empty')),
    });
    if (!newName || newName === oldName) return;

    try {
      await repo.renameBranch(oldName, newName);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: renamed "{1}" → "{2}".', meta.name, oldName, newName));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  private async pushSingleRepo(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const pushResult = await runPushWithProtection(repo, {
      repoName: meta.name,
      logger: this.logger,
    });
    if (pushResult.success) {
      if (!pushResult.rebased && !pushResult.forced) {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: pushed successfully.', meta.name));
      }
    } else if (!pushResult.cancelled) {
      this.showError(meta, pushResult.error);
    }
    await this.refresh();
  }

  private async compareSingleRepo(branchName: string, meta: RepoMeta): Promise<void> {
    await vscode.commands.executeCommand(
      'git.compareWithBranch',
      vscode.Uri.file(meta.rootPath),
      branchName,
    );
  }

  private async rebaseSingleRepo(onto: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.rebase(onto);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: rebased onto "{1}".', meta.name, onto));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  private async mergeSingleRepo(from: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    try {
      await repo.merge(from);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: merged "{1}".', meta.name, from));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  private async deleteSingleRepo(branchName: string, meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const confirm = await vscode.window.showQuickPick(
      [
        { label: `$(trash) ${t('Delete')}`, description: branchName, value: 'delete' },
        { label: `$(warning) ${t('Force delete')}`, description: t('even if not merged'), value: 'force' },
      ],
      { title: t("Delete branch '{0}' in {1}?", branchName, meta.name) }
    ) as { label: string; value: string } | undefined;
    if (!confirm) return;

    try {
      await repo.deleteBranch(branchName, confirm.value === 'force');
      vscode.window.showInformationMessage(t('VersionDock [{0}]: deleted "{1}".', meta.name, branchName));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  private async pullRemoteIntoCurrentSingleRepo(remoteBranch: string, meta: RepoMeta, useRebase: boolean): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;
    const remotes = (await repo.getRemotes().catch(() => [] as string[])).sort((a, b) => b.length - a.length);
    const remote = remotes.find(name => remoteBranch.startsWith(`${name}/`)) ?? '';
    const branch = remote ? remoteBranch.slice(remote.length + 1) : '';
    if (!remote || !branch) {
      vscode.window.showErrorMessage(t('VersionDock [{0}]: cannot determine the remote branch for "{1}".', meta.name, remoteBranch));
      return;
    }
    try {
      await repo.pullFromRemote(remote, branch, useRebase);
      vscode.window.showInformationMessage(
        t('VersionDock [{0}]: pulled "{1}" using {2}.', meta.name, remoteBranch, useRebase ? t('rebase') : t('merge'))
      );
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.refresh();
  }

  // ── Multi-repo branch actions ────────────────────────────────────────────

  private async newBranchFrom(fromBranch: string, metas: RepoMeta[]): Promise<void> {
    const branchName = await vscode.window.showInputBox({
      title: t("New Branch from '{0}'", fromBranch),
      prompt: t('Enter the new branch name'),
      validateInput: v => (v.trim() ? undefined : t('Branch name cannot be empty')),
    });
    if (!branchName) return;

    const checkoutPick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${t('Yes, checkout immediately')}`, value: true },
        { label: `$(close) ${t('No, just create the branch')}`, value: false },
      ],
      { title: t('New Branch — Checkout?') }
    ) as { label: string; value: boolean } | undefined;
    if (!checkoutPick) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Creating branch "{0}"…', branchName), cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            if (checkoutPick.value) {
              await repo.checkout(branchName, true, fromBranch);
            } else {
              await repo.createBranch(branchName, fromBranch);
            }
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(t('VersionDock: Branch "{0}" created in {1} repos.', branchName, metas.length));
        }
      }
    );
    await this.refresh();
  }

  private async pullBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    let results: Awaited<ReturnType<UpdateSummaryService['runAll']>> = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pulling "{0}"…', branchName), cancellable: false },
      async () => {
        results = await this.updateSummaryService.runAll(metas.map(meta => ({
          repoId: meta.id,
          branchName,
          execute: repo => repo.pullBranch(branchName),
        })));
      }
    );
    this.manager.notifyBranchesChanged();
    if (results.some(result => result.tracked)) {
      await this.updateSummaryService.notify(results);
    } else {
      const failed = results.filter(result => !result.ok);
      if (failed.length > 0) {
        vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', failed.length, failed.map(result => result.error ?? '').join('; ')));
      } else {
        vscode.window.showInformationMessage(t('VersionDock: Pulled in {0} repos.', metas.length));
      }
    }
    await this.refresh();
  }

  private async renameBranchAllRepos(oldName: string, metas: RepoMeta[]): Promise<void> {
    const newName = await vscode.window.showInputBox({
      title: t("Rename branch '{0}' in all repos", oldName),
      value: oldName,
      validateInput: v => (v.trim() ? undefined : t('Branch name cannot be empty')),
    });
    if (!newName || newName === oldName) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Renaming "{0}" → "{1}"…', oldName, newName), cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.renameBranch(oldName, newName);
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(t('VersionDock: Renamed "{0}" → "{1}" in {2} repos.', oldName, newName, metas.length));
        }
      }
    );
    await this.refresh();
  }

  private async compareBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    for (const meta of metas) {
      await vscode.commands.executeCommand(
        'git.compareWithBranch',
        vscode.Uri.file(meta.rootPath),
        branchName,
      );
    }
  }

  private async rebaseAllRepos(onto: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Rebasing onto "{0}"…', onto), cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.rebase(onto);
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(t('VersionDock: Rebased onto "{0}" in {1} repos.', onto, metas.length));
        }
      }
    );
    await this.refresh();
  }

  private async mergeBranchAllRepos(from: string, metas: RepoMeta[]): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Merging "{0}"…', from), cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.merge(from);
          } catch (e: unknown) {
            const errMsg = String(e);
            const isDirty = errMsg.includes('Your local changes') || errMsg.includes('overwritten by merge') || (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree';
            if (isDirty) {
              const pick = await vscode.window.showQuickPick(
                [
                  { label: `$(archive) ${t('Stash and merge')}`, detail: t('Save local changes to stash, then merge'), value: 'stash' },
                  { label: `$(close) ${t('Cancel')}`, detail: '', value: 'cancel' },
                ],
                {
                  title: t('VersionDock [{0}]: Uncommitted changes', meta.name),
                  placeHolder: t('Local changes would be overwritten by merging "{0}"', from),
                  ignoreFocusOut: true,
                }
              );
              if (pick?.value === 'stash') {
                try {
                  await repo.runWithGitWriteLock(async () => {
                    await repo.stashPush(t('WIP before merge of {0}', from));
                    await repo.merge(from);
                  });
                } catch (e2: unknown) {
                  errors.push(`${meta.name}: ${String(e2)}`);
                }
              }
            } else {
              errors.push(`${meta.name}: ${errMsg}`);
            }
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(t('VersionDock: Merged "{0}" in {1} repos.', from, metas.length));
        }
      }
    );
    await this.refresh();
  }

  private async deleteBranchAllRepos(branchName: string, metas: RepoMeta[]): Promise<void> {
    const confirm = await vscode.window.showQuickPick(
      [
        { label: `$(trash) ${t('Delete')}`, description: branchName, value: 'delete' },
        { label: `$(warning) ${t('Force delete')}`, description: t('even if not merged'), value: 'force' },
      ],
      { title: t("Delete branch '{0}' in all repos?", branchName) }
    ) as { label: string; value: string } | undefined;
    if (!confirm) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Deleting "{0}"…', branchName), cancellable: false },
      async () => {
        const errors: string[] = [];
        for (const meta of metas) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          try {
            await repo.deleteBranch(branchName, confirm.value === 'force');
          } catch (e: unknown) {
            errors.push(`${meta.name}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(t('VersionDock: Deleted "{0}" in {1} repos.', branchName, metas.length));
        }
      }
    );
    await this.refresh();
  }

  // ── Remote management ────────────────────────────────────────────────────

  private async showManageRemotesMenu(metas: RepoMeta[]): Promise<void> {
    if (metas.length === 0) return;

    let meta: RepoMeta;
    if (metas.length === 1) {
      meta = metas[0];
    } else {
      type RepoItem = vscode.QuickPickItem & { meta: RepoMeta };
      const repoItems: RepoItem[] = metas.map(m => ({
        label: formatRepoLabel(m, '$(root-folder)'),
        description: m.rootPath,
        meta: m,
      }));
      const pick = await vscode.window.showQuickPick(repoItems, {
        title: t('Manage Remotes — Select repository'),
      }) as RepoItem | undefined;
      if (!pick) return;
      meta = pick.meta;
    }

    await this.showRepoRemotesMenu(meta);
  }

  private async showRepoRemotesMenu(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const remotes = await repo.getRemotesWithUrls();

    type RemoteItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };

    const items: RemoteItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showRepoBranchMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(add) ${t('Add Remote…')}`,
        description: t('Configure a new remote'),
        action: () => this.addRemote(meta),
      },
    ];

    if (remotes.length > 0) {
      items.push({ label: t('REMOTES'), kind: vscode.QuickPickItemKind.Separator, action: async () => {} });
      for (const remote of remotes) {
        items.push({
          label: `$(cloud) ${remote.name}`,
          description: remote.fetchUrl,
          action: () => this.showSingleRemoteMenu(remote, meta),
        });
      }
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: t('{0} — Remotes', meta.name),
      matchOnDescription: true,
    }) as RemoteItem | undefined;

    if (pick) await pick.action();
  }

  private async showSingleRemoteMenu(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };

    const items: ActionItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showRepoRemotesMenu(meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(edit) ${t('Rename…')}`,
        description: t('Rename "{0}"', remote.name),
        action: () => this.renameRemote(remote, meta),
      },
      {
        label: `$(link) ${t('Change URL…')}`,
        description: remote.fetchUrl,
        action: () => this.changeRemoteUrl(remote, meta),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) ${t('Remove')}`,
        description: t('Remove remote "{0}"', remote.name),
        action: () => this.removeRemote(remote, meta),
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: t('Remote: {0} — {1}', remote.name, meta.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async addRemote(meta: RepoMeta): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const name = await vscode.window.showInputBox({
      title: t('Add Remote in {0} — Name', meta.name),
      prompt: t('Enter the remote name (e.g. origin, upstream)'),
      validateInput: v => (v.trim() ? undefined : t('Remote name cannot be empty')),
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
      title: t('Add Remote in {0} — URL', meta.name),
      prompt: t('Enter the remote URL'),
      validateInput: v => (v.trim() ? undefined : t('URL cannot be empty')),
    });
    if (!url) return;

    try {
      await repo.addRemote(name.trim(), url.trim());
      vscode.window.showInformationMessage(t('VersionDock [{0}]: remote "{1}" added.', meta.name, name));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.showRepoRemotesMenu(meta);
  }

  private async renameRemote(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const newName = await vscode.window.showInputBox({
      title: t('Rename remote "{0}" in {1}', remote.name, meta.name),
      value: remote.name,
      validateInput: v => (v.trim() ? undefined : t('Remote name cannot be empty')),
    });
    if (!newName || newName === remote.name) return;

    try {
      await repo.renameRemote(remote.name, newName.trim());
      vscode.window.showInformationMessage(t('VersionDock [{0}]: remote renamed "{1}" → "{2}".', meta.name, remote.name, newName));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.showRepoRemotesMenu(meta);
  }

  private async changeRemoteUrl(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const newUrl = await vscode.window.showInputBox({
      title: t('Change URL of "{0}" in {1}', remote.name, meta.name),
      value: remote.fetchUrl,
      validateInput: v => (v.trim() ? undefined : t('URL cannot be empty')),
    });
    if (!newUrl || newUrl === remote.fetchUrl) return;

    try {
      await repo.setRemoteUrl(remote.name, newUrl.trim());
      vscode.window.showInformationMessage(t('VersionDock [{0}]: URL of "{1}" updated.', meta.name, remote.name));
    } catch (e: unknown) {
      this.showError(meta, e);
    }
    await this.showRepoRemotesMenu(meta);
  }

  private async removeRemote(
    remote: { name: string; fetchUrl: string; pushUrl: string },
    meta: RepoMeta
  ): Promise<void> {
    const repo = this.manager.getRepo(meta.id);
    if (!repo) return;

    const confirm = await vscode.window.showQuickPick(
      [
        { label: `$(trash) ${t('Remove "{0}"', remote.name)}`, value: true },
        { label: `$(close) ${t('Cancel')}`, value: false },
      ],
      { title: t('Remove remote "{0}" from {1}?', remote.name, meta.name) }
    ) as { label: string; value: boolean } | undefined;

    if (!confirm?.value) return;

    try {
      await repo.removeRemote(remote.name);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: remote "{1}" removed.', meta.name, remote.name));
    } catch (e: unknown) {
      vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', meta.name, String(e)));
    }
    await this.showRepoRemotesMenu(meta);
  }

  dispose(): void {
    if (this.safetyTimeoutTimer) {
      clearTimeout(this.safetyTimeoutTimer);
      this.safetyTimeoutTimer = undefined;
    }
    if (this.loadingTimer) {
      clearTimeout(this.loadingTimer);
      this.loadingTimer = undefined;
    }
    this.statusBarItem.dispose();
    this.statusDisposable?.dispose();
    this.statusOperationDisposable?.dispose();
    this.branchDisposable?.dispose();
    this.configDisposable?.dispose();
    this.editorDisposable?.dispose();
    this.windowStateDisposable?.dispose();
  }
}
